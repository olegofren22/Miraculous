// public/nav-loader.js - Handles loading and managing shared navigation

// Load navigation into the page
async function loadNavigation() {
    try {
        const response = await fetch('/nav.html');
        if (!response.ok) throw new Error('Failed to load navigation');
        
        const navHtml = await response.text();
        
        // Insert navigation at the top of the body
        const body = document.body;
        body.insertAdjacentHTML('afterbegin', navHtml);
        
        // Highlight the current page in navigation
        highlightCurrentPage();
        
        // Update server info
        updateServerInfo();
        
        return true;
    } catch (error) {
        console.error('Error loading navigation:', error);
        // Fallback: show minimal navigation
        showFallbackNavigation();
        return false;
    }
}

// Highlight the current page in the navigation
function highlightCurrentPage() {
    const currentPage = window.location.pathname.split('/').pop() || 'crafter.html';
    const links = document.querySelectorAll('.nav-link');
    
    links.forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPage) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });
}

// Update server info in the navigation
async function updateServerInfo() {
    const serverInfoElement = document.getElementById('serverInfo');
    if (!serverInfoElement) return;
    
    try {
        const response = await fetch('/health');
        const data = await response.json();
        serverInfoElement.textContent = 
            `Server: Healthy | API: ${data.apiConfigured ? 'Configured' : 'Not Configured'}`;
    } catch (error) {
        serverInfoElement.textContent = 'Server: Error connecting';
    }
}

// Fallback navigation if nav.html can't be loaded
function showFallbackNavigation() {
    const fallbackNav = `
        <div class="nav-bar" style="background: white; padding: 15px 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <div class="nav-links" style="display: flex; gap: 10px; flex-wrap: wrap;">
                <a href="/bundle-buy.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Bundle Buy</a>
                <a href="/bundle-creator.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Bundle Creator</a>
                <a href="/bundle-list-by-id.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Bundle List by ID</a>
                <a href="/bundle-price-change.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Bundle Price Change</a>
                <a href="/bundle-remove-delete.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Bundle Remove/Delete</a>
                <a href="/crafter.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Card Crafter</a>
                <a href="/crafter-old.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Card Crafter (Old)</a>
                <a href="/lister.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Card Lister</a>
                <a href="/pack-buy-open-CS.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Packs buy-open CS</a>
                <a href="/pack-buy-open-KL.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Packs buy-open KL</a>
                <a href="/pack-lister.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Pack Lister</a>
                <a href="/pack-multi-open.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Pack Multi-Open</a>
                <a href="/pack-multi-scan.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Pack Multi-Scan</a>
                <a href="/pack-solo-scan-open.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Pack Solo Scan/Open</a>
                <a href="/scanner.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Collection Scanner</a>
                <a href="/scanner-old.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Collection Scanner (Old)</a>
                <a href="/spinner.html" class="nav-link" style="padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold; background-color: #e0e0e0; color: #333;">Spinner Pro</a>
            </div>
            <div class="server-info" style="color: #666; font-size: 12px;">Server: Unknown</div>
        </div>
    `;
    document.body.insertAdjacentHTML('afterbegin', fallbackNav);
    highlightCurrentPage();
}

// Auto-load navigation when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadNavigation);
} else {
    loadNavigation();
}