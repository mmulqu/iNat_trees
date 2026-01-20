# iNaturalist Trees - Self-Hosted Frontend

This is the static frontend for the iNaturalist Taxonomic Tree Viewer. It connects to a Cloudflare Worker backend for data storage and API functionality.

## Architecture

- **Frontend (this repo)**: Static HTML/CSS/JavaScript files hosted on GitHub Pages (or any static host)
- **Backend**: Cloudflare Worker + D1 Database (remains unchanged at `https://inat-trees-worker.intrinsic3141.workers.dev`)

## Quick Deploy to GitHub Pages

1. **Push this repo to GitHub**:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/inat-trees-selfhost.git
   git push -u origin main
   ```

2. **Enable GitHub Pages**:
   - Go to repository Settings → Pages
   - Source: Deploy from branch
   - Branch: `main` / `root`
   - Save

3. **Update OAuth Redirect URI**:
   - Edit `auth.js` and update the `REDIRECT_URI` constant to your GitHub Pages URL:
     ```javascript
     const REDIRECT_URI = `https://YOUR_USERNAME.github.io/inat-trees-selfhost/auth/callback`;
     ```
   - Update your iNaturalist OAuth app settings to include this redirect URI:
     - Go to https://www.inaturalist.org/oauth/applications
     - Edit your app (Client ID: `kNg0gso6U_16O7tkEJotSnmtcNE88dd_Xs-zb5SS8Pw`)
     - Add the new redirect URI
     - Save

4. **Commit and push the auth.js change**:
   ```bash
   git add auth.js
   git commit -m "Update redirect URI for GitHub Pages"
   git push
   ```

5. **Access your site**:
   - Your app will be live at `https://YOUR_USERNAME.github.io/inat-trees-selfhost/`

## Alternative Hosting Options

This can be hosted on any static site hosting service:

- **Netlify**: Drop the folder or connect your GitHub repo
- **Vercel**: Import your GitHub repo
- **Cloudflare Pages**: Connect to GitHub and deploy
- **Any web server**: Just serve the files with a web server

## Files Included

### Core Application
- `index.html` - Main application interface
- `style.css` - Application styles
- `battle-animation.css` - Animation styles

### JavaScript Modules
- `auth.js` - iNaturalist OAuth authentication
- `ui-auth.js` - Authentication UI components
- `script.js` - Core application logic
- `tree-manager.js` - Tree visualization and management
- `taxon-autocomplete.js` - Taxon search autocomplete
- `compare-users.js` - User comparison functionality
- `markmap-integration.js` - Mindmap visualization
- `integration.js` - Feature integrations
- `battle-animation.js` - Tree battle animations
- `TaxonomyStats.js` - Statistics and charts
- `Taxonomycharts.js` - Chart components
- `tab-controller.js` - Tab navigation
- `theme-toggle.js` - Dark/light theme switching
- `pkce.js` - OAuth PKCE helper
- `checklist-tab.js` - Checklist functionality
- `checkpoint-ui.js` - Checkpoint management UI
- `sw.js` - Service worker (optional)

### Assets
- `assets/` - Icons, images, manifest
- `auth/callback.html` - OAuth callback page
- `attached_assets/` - Additional resources

## Configuration

### API Endpoint
The frontend is configured to connect to the Cloudflare Worker at:
```
https://inat-trees-worker.intrinsic3141.workers.dev
```

This is set in `tree-manager.js`:
```javascript
const API_BASE = (window.API_BASE
  || localStorage.getItem('apiBase')
  || 'https://inat-trees-worker.intrinsic3141.workers.dev'
).replace(/\/+$/,'');
```

You can override this by:
- Setting `window.API_BASE` in a script before loading tree-manager.js
- Setting `localStorage.setItem('apiBase', 'YOUR_WORKER_URL')` in the browser console

### Public Mode
The app can run in public mode (no login required) by:
- Adding `?mode=public` to the URL
- Setting `window.PUBLIC_MODE = true` in index.html (already enabled)

## Backend (Not Included)

The backend Cloudflare Worker and D1 database are NOT included in this repo. They remain deployed separately on Cloudflare Workers.

Backend components (not in this repo):
- `worker.js` - Cloudflare Worker backend
- `wrangler.toml` - Cloudflare configuration
- D1 Database with tables: `taxa`, `checkpoints`, `user_obs_events`, etc.

## Development

To test locally:
```bash
# Using Python
python -m http.server 8000

# Using Node.js
npx http-server

# Using PHP
php -S localhost:8000
```

Then open `http://localhost:8000` in your browser.

## License

[Add your license here]

## Credits

Original iNaturalist Trees application.
