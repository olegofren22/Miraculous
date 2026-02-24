const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
    BASE_URL_REF: process.env.BASE_URL_REF,
    BASE_URL_SPIN: process.env.BASE_URL_SPIN,
    BASE_URL_BUY_SPIN: process.env.BASE_URL_BUY_SPIN,
    BASE_URL_OPENPACK: process.env.BASE_URL_OPENPACK,
    BASE_URL_ACH: process.env.BASE_URL_ACH,
    BASE_URL_MONEY: process.env.BASE_URL_MONEY,
    USERS_FILE: 'users.json',
};

// Prize mapping for console logs only
const PRIZE_MAP = {
    11948: '5,000 Spraycoins',
    11953: 'Standard Box 2026',
    11947: '500 Spraycoins',
    11949: '1,000,000 Spraycoins',
    11950: '100,000 Spraycoins',
    11951: '2,500 Spraycoins',
    11952: '1,000 Spraycoins'
};

// Pack IDs that need opening
const PACK_IDS = [11953];

// Retry configuration
const RETRY_CONFIG = {
    MAX_RETRIES: 3,
    INITIAL_DELAY: 5000,      // 5 seconds
    BACKOFF_MULTIPLIER: 3,    // 5, 15, 45 seconds
    RATE_LIMIT_DELAY: 45000,   // 45 seconds for 429 errors
    MAX_RETRY_DELAY: 60000     // Max 60 seconds
};

// Global state
let userData = {};
let userQueue = [];
let activeUserIds = [];
let processingTimeout = null;
let isPaused = false;

// Settings (will be set via dashboard)
let settings = {
    maxConcurrent: 5,
    spinDelay: 7,
    minFundsThreshold: 10000
};

// Debug logs (only important events for dashboard)
const debugLogs = [];

// Log function - important events only for dashboard
function log(userId, message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, userId, message, type };
    
    // Always show in console with type
    console.log(`[${timestamp}] [${type}] ${userId}: ${message}`);
    
    // Store for dashboard (limited to 200)
    debugLogs.unshift(logEntry);
    if (debugLogs.length > 200) debugLogs.pop();
}

// API request function with detailed console logging and error handling
async function makeAPIRequest(url, method = 'GET', headers = {}, data = null, userId = 'system') {
    const methodUpper = method.toUpperCase();
    console.log(`[${new Date().toISOString()}] [API] ${userId}: 🌐 ${methodUpper} ${url.split('?')[0]}`);
    
    try {
        const response = await axios({
            method: methodUpper,
            url,
            headers: { 'Content-Type': 'application/json', ...headers },
            data,
            timeout: 15000
        });
        console.log(`[${new Date().toISOString()}] [API] ${userId}: ✅ ${methodUpper} ${url.split('?')[0]} (${response.status})`);
        return { success: true, data: response.data, status: response.status };
    } catch (error) {
        const status = error.response?.status;
        const errorMsg = error.message;
        
        console.log(`[${new Date().toISOString()}] [API] ${userId}: ❌ ${methodUpper} ${url.split('?')[0]} - ${errorMsg} (${status || 'unknown'})`);
        
        // Handle specific error codes
        if (status === 401) {
            return {
                success: false,
                error: 'unauthorized',
                status: 401,
                retryable: true,
                needsRefresh: true
            };
        }
        
        if (status === 429) {
            return {
                success: false,
                error: 'rate_limit',
                status: 429,
                retryable: true,
                rateLimit: true
            };
        }
        
        // All other errors (including 403) are retryable if they're server errors or network issues
        const isRetryable = !status || status >= 400 || status === 408 || error.code === 'ECONNABORTED';
        
        return {
            success: false,
            error: errorMsg,
            status,
            retryable: isRetryable
        };
    }
}

// Retry wrapper with exponential backoff for atomic operations
async function retryAtomicOperation(operation, userId, context = 'operation', retryCount = 0) {
    try {
        // Attempt the operation
        const result = await operation();
        
        // Check if we need special handling
        if (!result.success) {
            // Handle rate limiting
            if (result.rateLimit) {
                if (retryCount < RETRY_CONFIG.MAX_RETRIES) {
                    const waitTime = RETRY_CONFIG.RATE_LIMIT_DELAY;
                    log(userId, `Rate limited, waiting ${waitTime/1000}s before retry ${retryCount + 1}/${RETRY_CONFIG.MAX_RETRIES}`, 'RETRY');
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    return retryAtomicOperation(operation, userId, context, retryCount + 1);
                }
            }
            
            // Handle token expiration
            if (result.needsRefresh) {
                log(userId, `Token expired, refreshing...`, 'RETRY');
                const refreshSuccess = await refreshToken(userId);
                if (refreshSuccess) {
                    // Retry immediately with new token (don't count as retry)
                    return retryAtomicOperation(operation, userId, context, retryCount);
                }
            }
            
            // Handle other retryable errors with exponential backoff
            if (result.retryable && retryCount < RETRY_CONFIG.MAX_RETRIES) {
                const delay = Math.min(
                    RETRY_CONFIG.INITIAL_DELAY * Math.pow(RETRY_CONFIG.BACKOFF_MULTIPLIER, retryCount),
                    RETRY_CONFIG.MAX_RETRY_DELAY
                );
                log(userId, `${context} failed, waiting ${delay/1000}s before retry ${retryCount + 1}/${RETRY_CONFIG.MAX_RETRIES}`, 'RETRY');
                await new Promise(resolve => setTimeout(resolve, delay));
                return retryAtomicOperation(operation, userId, context, retryCount + 1);
            }
            
            // Max retries exceeded
            log(userId, `${context} failed permanently after ${retryCount} retries`, 'ERROR');
            return result;
        }
        
        // Success! Reset any retry tracking
        if (userData[userId]) {
            userData[userId].retryCount = 0;
        }
        return result;
        
    } catch (error) {
        // Unexpected error in the retry logic itself
        log(userId, `Unexpected error in retry logic: ${error.message}`, 'ERROR');
        return { success: false, error: error.message, permanent: true };
    }
}

// Load user configuration
async function loadUserConfig() {
    try {
        const configData = await fs.readFile(CONFIG.USERS_FILE, 'utf8');
        const users = JSON.parse(configData);
        
        for (const user of users) {
            userData[user.userId] = {
                userId: user.userId,
                nick: user.userNick || user.nick || user.name || user.userId,
                refreshToken: user.refreshToken,
                jwtToken: null,
                isActive: false,
                status: 'idle',
                initialFunds: 0,
                currentFunds: 0,
                totalSpinsRun: 0,
                totalPacksOpened: 0,
                achievementsClaimed: 0,
                spinsRemaining: 0,
                spinsDoneInRound: 0,
                lastError: null,
                startTime: null,
                endTime: null,
                retryCount: 0
            };
        }
        
        log('system', `Loaded ${users.length} users from config`, 'INIT');
        return true;
    } catch (error) {
        console.error('Error loading user config:', error);
        return false;
    }
}

// Refresh token for a user
async function refreshToken(userId) {
    const user = userData[userId];
    if (!user) return false;
    
    const result = await makeAPIRequest(
        CONFIG.BASE_URL_REF, 
        'POST', 
        { 'Content-Type': 'application/json' },
        { refreshToken: user.refreshToken },
        userId
    );

    if (result.success && result.data.data?.jwt) {
        user.jwtToken = result.data.data.jwt;
        user.isActive = true;
        log(userId, 'Token refreshed', 'TOKEN');
        return true;
    } else {
        user.isActive = false;
        user.status = 'error';
        user.lastError = 'Token refresh failed';
        log(userId, 'Token refresh failed', 'ERROR');
        return false;
    }
}

// Check user funds (updates currentFunds)
async function checkFunds(userId, isInitial = false) {
    const user = userData[userId];
    if (!user || !user.jwtToken) return null;

    const result = await retryAtomicOperation(
        async () => await makeAPIRequest(
            CONFIG.BASE_URL_MONEY, 
            'GET', 
            { 'x-user-jwt': user.jwtToken }, 
            null, 
            userId
        ),
        userId,
        'check funds'
    );
    
    if (result.success && result.data.data) {
        const silvercoins = result.data.data.silvercoins || 0;
        user.currentFunds = silvercoins;
        
        // Only set initial funds if this is the first check
        if (isInitial && user.initialFunds === 0) {
            user.initialFunds = silvercoins;
            log(userId, `Initial funds: ${silvercoins.toLocaleString()}`, 'FUNDS');
        } else if (!isInitial) {
            console.log(`[${new Date().toISOString()}] [FUNDS] ${userId}: Current funds: ${silvercoins.toLocaleString()}`);
        }
        
        return silvercoins;
    }
    return null;
}

// Claim achievements for a user
async function claimAchievements(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) return 0;

    let totalClaimed = 0;
    const userAchievementsUrl = `${CONFIG.BASE_URL_ACH}/${user.userId}/user`;
    const headers = { 'x-user-jwt': user.jwtToken };

    const achievementsResult = await retryAtomicOperation(
        async () => await makeAPIRequest(userAchievementsUrl, 'GET', headers, null, userId),
        userId,
        'fetch achievements'
    );
    
    if (!achievementsResult.success) {
        return 0;
    }

    const validIDs = [];
    const categories = ['achievements', 'daily', 'weekly', 'monthly'];

    categories.forEach((category) => {
        if (achievementsResult.data.data[category]) {
            achievementsResult.data.data[category].forEach((item) => {
                if (item.progress?.claimAvailable) {
                    validIDs.push(item.id);
                }
            });
        }
    });

    if (validIDs.length === 0) return 0;

    log(userId, `Found ${validIDs.length} achievements to claim`, 'ACH');

    for (const achievementId of validIDs) {
        const claimUrl = `${CONFIG.BASE_URL_ACH}/${achievementId}/claim/`;
        const claimResult = await retryAtomicOperation(
            async () => await makeAPIRequest(claimUrl, 'POST', headers, null, userId),
            userId,
            'claim achievement'
        );
        
        if (claimResult.success) {
            totalClaimed++;
        }
        
        // Small delay between claims
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (totalClaimed > 0) {
        user.achievementsClaimed += totalClaimed;
        log(userId, `Claimed ${totalClaimed} achievements`, 'ACH');
    }
    
    return totalClaimed;
}

// Buy and execute spin as ONE ATOMIC OPERATION
async function buyAndSpinAtomic(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return { success: false };

    // Buy spin
    const buyResult = await makeAPIRequest(
        CONFIG.BASE_URL_BUY_SPIN,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { categoryId: 1, amount: 1 },
        userId
    );

    if (!buyResult.success) {
        // Pass through error types
        return {
            success: false,
            needsRefresh: buyResult.needsRefresh,
            rateLimit: buyResult.rateLimit,
            retryable: buyResult.retryable,
            error: buyResult.error,
            stage: 'buy'
        };
    }

    // Execute spin (only if buy succeeded)
    const spinResult = await makeAPIRequest(
        CONFIG.BASE_URL_SPIN,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { spinnerId: 6832 },
        userId
    );

    if (!spinResult.success) {
        // Spin failed but buy succeeded - log it
        log(userId, 'CRITICAL: Spin purchased but execution failed', 'ERROR');
        return {
            success: false,
            needsRefresh: spinResult.needsRefresh,
            rateLimit: spinResult.rateLimit,
            retryable: spinResult.retryable,
            error: spinResult.error,
            stage: 'spin',
            boughtButFailed: true
        };
    }

    // Both operations succeeded
    const spinData = spinResult.data.data;
    const resultId = spinData.id;
    
    // Log spin result to console only
    const prizeName = PRIZE_MAP[resultId] || `Prize ID ${resultId}`;
    console.log(`[${new Date().toISOString()}] [SPIN] ${userId}: 🎰 Result: ${prizeName}`);

    // Check for pack
    let packOpened = false;
    if (PACK_IDS.includes(resultId) && spinData.packs?.length > 0) {
        const packId = spinData.packs[0].id;
        log(userId, `Got pack from spin!`, 'PACK');
        
        const packResult = await makeAPIRequest(
            CONFIG.BASE_URL_OPENPACK,
            'POST',
            { 'x-user-jwt': user.jwtToken },
            { packId },
            userId
        );

        if (packResult.success) {
            packOpened = true;
            log(userId, `Pack opened successfully`, 'PACK');
        }
    }

    return {
        success: true,
        spinData,
        packOpened,
        resultId,
        prizeName
    };
}

// Process a single spin for a user (with full atomic retry)
async function processUserSpin(userId) {
    const user = userData[userId];
    if (!user) return { success: false };

    // Use the atomic retry wrapper around the entire buy+spin operation
    const result = await retryAtomicOperation(
        async () => await buyAndSpinAtomic(userId),
        userId,
        'buy+spin'
    );

    if (result.success) {
        // Update user stats
        user.totalSpinsRun++;
        user.spinsDoneInRound++;
        user.spinsRemaining--;
        user.retryCount = 0;
        
        // Handle pack opening delay if needed
        if (result.packOpened) {
            user.totalPacksOpened++;
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        return { success: true };
        
    } else {
        // Mark as error
        user.status = 'error';
        user.lastError = result.error || 'Spin failed';
        
        if (result.boughtButFailed) {
            log(userId, 'WARNING: Spin was purchased but execution failed', 'ERROR');
        }
        
        return { success: false };
    }
}

// Initialize a user for a new round (checks current funds)
async function initializeUserRound(userId) {
    const user = userData[userId];
    if (!user || !user.isActive) return false;

    // Check current funds (this updates currentFunds)
    const funds = await checkFunds(userId, false);
    if (!funds) return false;

    // If funds below threshold, user is done
    if (funds < settings.minFundsThreshold) {
        user.status = 'completed';
        user.endTime = new Date().toISOString();
        log(userId, `User completed (final funds: ${funds.toLocaleString()})`, 'DONE');
        return false;
    }

    // Calculate spins for this round (funds / 1000)
    const spinsThisRound = Math.floor(funds / 1000);
    user.spinsRemaining = spinsThisRound;
    user.spinsDoneInRound = 0;
    user.status = 'ready';
    
    log(userId, `New round: ${spinsThisRound} spins (funds: ${funds.toLocaleString()})`, 'ROUND');
    return true;
}

// Process next user in the active pool
async function processNextUser() {
    if (isPaused || activeUserIds.length === 0) return;

    // Filter out users that are not ready
    const readyUsers = activeUserIds.filter(id => {
        const user = userData[id];
        return user && user.isActive && user.status === 'ready' && user.spinsRemaining > 0;
    });

    if (readyUsers.length === 0) {
        // No ready users, try to add more from queue
        await addUsersToActivePool();
        return;
    }

    // Pick a random user from ready pool
    const randomIndex = Math.floor(Math.random() * readyUsers.length);
    const userId = readyUsers[randomIndex];
    const user = userData[userId];

    // Mark as spinning
    user.status = 'spinning';
    
    // Process one spin (with atomic retry)
    const spinResult = await processUserSpin(userId);
    
    if (spinResult.success) {
        // If no spins remaining, check if user needs a new round or is done
        if (user.spinsRemaining <= 0) {
            log(userId, 'Round complete, claiming achievements...', 'ROUND');
            await claimAchievements(userId);
            
            // Check funds for next round
            const funds = await checkFunds(userId, false);
            if (funds && funds >= settings.minFundsThreshold) {
                // Start new round
                const newSpins = Math.floor(funds / 1000);
                user.spinsRemaining = newSpins;
                user.spinsDoneInRound = 0;
                user.status = 'ready';
                log(userId, `New round started: ${newSpins} spins (funds: ${funds.toLocaleString()})`, 'ROUND');
            } else {
                // User is done
                user.status = 'completed';
                user.endTime = new Date().toISOString();
                log(userId, `User completed (final funds: ${funds?.toLocaleString() || 0})`, 'DONE');
                
                // Remove from active pool
                activeUserIds = activeUserIds.filter(id => id !== userId);
                
                // Add next user from queue
                await addUsersToActivePool();
            }
        } else {
            // Still has spins, mark as ready again
            user.status = 'ready';
        }
    } else {
        // Spin failed, mark as error and remove from active pool
        user.status = 'error';
        user.lastError = 'Spin failed after retries';
        log(userId, 'Spin failed permanently, removing from pool', 'ERROR');
        activeUserIds = activeUserIds.filter(id => id !== userId);
        await addUsersToActivePool();
    }

    // Schedule next user after delay
    if (!isPaused) {
        if (processingTimeout) {
            clearTimeout(processingTimeout);
        }
        processingTimeout = setTimeout(processNextUser, settings.spinDelay * 1000);
    }
}

// Add users from queue to active pool
async function addUsersToActivePool() {
    while (activeUserIds.length < settings.maxConcurrent && userQueue.length > 0) {
        const nextUserId = userQueue.shift();
        const user = userData[nextUserId];
        
        if (!user || !user.isActive) continue;

        // Initialize user for first round
        const initialized = await initializeUserRound(nextUserId);
        if (initialized) {
            activeUserIds.push(nextUserId);
            user.startTime = user.startTime || new Date().toISOString();
            log(nextUserId, `Added to active pool`, 'QUEUE');
        } else {
            // User couldn't be initialized (probably below threshold)
            user.status = 'completed';
            user.endTime = new Date().toISOString();
            log(nextUserId, `Skipped - below threshold`, 'QUEUE');
        }
    }
}

// Initialize all users (refresh tokens, check initial funds)
async function initializeAllUsers() {
    log('system', 'Initializing application...', 'INIT');
    
    const success = await loadUserConfig();
    if (!success) return false;
    
    log('system', 'Refreshing tokens for all users...', 'INIT');
    
    const userIds = Object.keys(userData);
    for (const userId of userIds) {
        await refreshToken(userId);
        await checkFunds(userId, true);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Create random queue
    userQueue = userIds.sort(() => Math.random() - 0.5);
    
    log('system', `System ready. ${userIds.length} users in queue. Click Start to begin.`, 'INIT');
    return true;
}

// Start processing
function startProcessing(newSettings) {
    if (newSettings) {
        if (newSettings.maxConcurrent) settings.maxConcurrent = parseInt(newSettings.maxConcurrent);
        if (newSettings.spinDelay) settings.spinDelay = parseFloat(newSettings.spinDelay);
        if (newSettings.minFundsThreshold) settings.minFundsThreshold = parseInt(newSettings.minFundsThreshold);
    }
    
    isPaused = false;
    
    if (processingTimeout) {
        clearTimeout(processingTimeout);
        processingTimeout = null;
    }
    
    activeUserIds = [];
    
    Object.values(userData).forEach(user => {
        if (user.status !== 'completed') {
            user.status = 'idle';
            user.spinsRemaining = 0;
            user.spinsDoneInRound = 0;
        }
    });
    
    addUsersToActivePool().then(() => {
        log('system', `Processing started (Max: ${settings.maxConcurrent}, Delay: ${settings.spinDelay}s, Min Funds: ${settings.minFundsThreshold})`, 'START');
        
        if (activeUserIds.length > 0) {
            processNextUser();
        } else {
            log('system', 'No users available to start', 'WARN');
        }
    });
}

// Pause processing
function pauseProcessing() {
    isPaused = true;
    if (processingTimeout) {
        clearTimeout(processingTimeout);
        processingTimeout = null;
    }
    log('system', 'Processing paused', 'PAUSE');
}

// Reset everything
function resetSystem() {
    isPaused = false;
    if (processingTimeout) {
        clearTimeout(processingTimeout);
        processingTimeout = null;
    }
    
    Object.values(userData).forEach(user => {
        user.totalSpinsRun = 0;
        user.totalPacksOpened = 0;
        user.achievementsClaimed = 0;
        user.initialFunds = user.currentFunds;
        user.spinsRemaining = 0;
        user.spinsDoneInRound = 0;
        user.status = 'idle';
        user.lastError = null;
        user.startTime = null;
        user.endTime = null;
        user.retryCount = 0;
    });
    
    userQueue = Object.keys(userData).sort(() => Math.random() - 0.5);
    activeUserIds = [];
    
    log('system', `System reset. ${userQueue.length} users in queue.`, 'RESET');
}

// Safe user data for frontend
function safeUsersSnapshot() {
    const out = {};
    for (const [id, u] of Object.entries(userData)) {
        out[id] = {
            userId: u.userId,
            nick: u.nick,
            jwtToken: u.jwtToken || 'No token',
            isActive: u.isActive,
            status: u.status || 'idle',
            totalSpinsRun: u.totalSpinsRun || 0,
            totalPacksOpened: u.totalPacksOpened || 0,
            initialFunds: u.initialFunds || 0,
            currentFunds: u.currentFunds || 0,
            spinsRemaining: u.spinsRemaining || 0,
            spinsDoneInRound: u.spinsDoneInRound || 0,
            achievementsClaimed: u.achievementsClaimed || 0,
            lastError: u.lastError,
            startTime: u.startTime,
            endTime: u.endTime
        };
    }
    return out;
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API Routes
app.get('/api/users', (req, res) => {
    res.json(safeUsersSnapshot());
});

app.get('/api/debug-logs', (req, res) => {
    res.json(debugLogs.slice(0, 100));
});

app.get('/api/system-state', (req, res) => {
    res.json({
        settings,
        isPaused,
        activeCount: activeUserIds.length,
        queueLength: userQueue.length,
        totalUsers: Object.keys(userData).length
    });
});

// Control endpoints
app.post('/api/start', (req, res) => {
    const { maxConcurrent, spinDelay, minFundsThreshold } = req.body;
    startProcessing({ maxConcurrent, spinDelay, minFundsThreshold });
    res.json({ success: true });
});

app.post('/api/pause', (req, res) => {
    pauseProcessing();
    res.json({ success: true });
});

app.post('/api/reset', (req, res) => {
    resetSystem();
    res.json({ success: true });
});

app.post('/api/check-all-funds', async (req, res) => {
    log('system', 'Manual check funds for all users', 'FUNDS');
    const userIds = Object.keys(userData);
    for (const userId of userIds) {
        await checkFunds(userId, false);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    res.json({ success: true });
});

app.post('/api/user/:userId/refresh', async (req, res) => {
    const userId = req.params.userId;
    const success = await refreshToken(userId);
    await checkFunds(userId, false);
    res.json({ success });
});

app.post('/api/user/:userId/check-funds', async (req, res) => {
    const userId = req.params.userId;
    const funds = await checkFunds(userId, false);
    res.json({ success: funds !== null, funds });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    initializeAllUsers();
});