const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables (set these in Render dashboard)
const API_BASE = process.env.API_BASE; // No default - must be set in Render
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 30000;

// Path for config storage
const CONFIG_FILE = path.join(__dirname, 'crafting-config.json');

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Load or create default config
let craftingConfig = {};
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            craftingConfig = JSON.parse(data);
            console.log('Loaded crafting config:', craftingConfig);
        } else {
            // Create default config
            craftingConfig = {
                requirements: [
                    {
                        requirementId: 3235,
                        cardsPerCraft: 16,
                        collectionIds: [17920, 17921, 17922]
                    },
                    {
                        requirementId: 3236,
                        cardsPerCraft: 8,
                        collectionIds: [17923, 17924, 17925]
                    },
                    {
                        requirementId: 3237,
                        cardsPerCraft: 4,
                        collectionIds: [17953, 17986, 17987]
                    }
                ],
                craftingPlanId: "3202",
                silvercoins: 5000,
                maxCrafts: 10,
                operationDelay: 3400
            };
            saveConfig();
        }
    } catch (error) {
        console.error('Error loading config:', error);
        // Use defaults if loading fails
        craftingConfig = {
            requirements: [
                { requirementId: 3235, cardsPerCraft: 16, collectionIds: [17920, 17921, 17922] },
                { requirementId: 3236, cardsPerCraft: 8, collectionIds: [17923, 17924, 17925] },
                { requirementId: 3237, cardsPerCraft: 4, collectionIds: [17953, 17986, 17987] }
            ],
            craftingPlanId: "3202",
            silvercoins: 5000,
            maxCrafts: 10,
            operationDelay: 3400
        };
        saveConfig();
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(craftingConfig, null, 2));
        console.log('Saved crafting config');
    } catch (error) {
        console.error('Error saving config:', error);
    }
}

// Load config on startup
loadConfig();

// Proxy endpoint - all URLs are constructed server-side
app.post('/proxy', async (req, res) => {
    const { endpoint, method, headers, data } = req.body;
    
    if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint is required' });
    }

    // Construct full URL server-side using environment variable
    const url = `${API_BASE}${endpoint}`;
    
    // Validate that we're only calling API
    if (!url.startsWith(API_BASE)) {
        return res.status(403).json({ error: 'Invalid endpoint' });
    }

    // Prepare headers
    const proxyHeaders = {
        ...headers,
        'User-Agent': 'Card-Crafter/1.0',
    };

    // Remove headers that might cause issues
    delete proxyHeaders['host'];
    delete proxyHeaders['origin'];
    delete proxyHeaders['referer'];

    try {
        const response = await axios({
            url: url,
            method: method || 'GET',
            headers: proxyHeaders,
            data: data,
            timeout: REQUEST_TIMEOUT,
            validateStatus: null
        });

        console.log(`[${new Date().toISOString()}] ${method} ${endpoint} -> ${response.status}`);
        res.status(response.status).json(response.data);
    } catch (error) {
        console.error(`Proxy error:`, error.message);
        
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({ error: 'Request timeout' });
        }
        
        res.status(500).json({ error: 'Proxy error', message: error.message });
    }
});

// Configuration endpoints
app.get('/api/config', (req, res) => {
    res.json(craftingConfig);
});

app.post('/api/config', (req, res) => {
    try {
        const newConfig = req.body;
        
        // Validate the config structure
        if (!newConfig.requirements || !Array.isArray(newConfig.requirements)) {
            return res.status(400).json({ error: 'Invalid requirements format' });
        }
        
        // Ensure each requirement has the required fields
        for (const req of newConfig.requirements) {
            if (!req.requirementId || !req.cardsPerCraft || !req.collectionIds || !Array.isArray(req.collectionIds)) {
                return res.status(400).json({ error: 'Invalid requirement structure' });
            }
        }
        
        craftingConfig = newConfig;
        saveConfig();
        res.json({ success: true, config: craftingConfig });
    } catch (error) {
        console.error('Error saving config:', error);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        apiConfigured: !!API_BASE
    });
});

// Redirect root to crafter
app.get('/', (req, res) => {
    res.redirect('/crafter.html');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API Base: ${API_BASE}`);
    console.log(`Config file: ${CONFIG_FILE}`);
});