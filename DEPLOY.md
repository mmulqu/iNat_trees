# Deployment Guide

## Step-by-Step GitHub Pages Deployment

### 1. Prepare Your GitHub Repository

First, create a new repository on GitHub:
- Go to https://github.com/new
- Name it `inat-trees-selfhost` (or your preferred name)
- Make it public (required for free GitHub Pages)
- **Don't initialize with README** (we already have one)
- Create repository

### 2. Update OAuth Redirect URI

Before deploying, you need to update the OAuth callback URL to match your GitHub Pages URL.

**Your GitHub Pages URL will be**: `https://YOUR_GITHUB_USERNAME.github.io/inat-trees-selfhost/`

Edit `auth.js` and change line 3:

```javascript
// FROM:
const REDIRECT_URI = `https://inat-trees.replit.app/auth/callback`;

// TO:
const REDIRECT_URI = `https://YOUR_GITHUB_USERNAME.github.io/inat-trees-selfhost/auth/callback`;
```

Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username.

### 3. Update iNaturalist OAuth App

You need to add the new redirect URI to your iNaturalist OAuth application:

1. Go to https://www.inaturalist.org/oauth/applications
2. Find and click on your app (Client ID: `kNg0gso6U_16O7tkEJotSnmtcNE88dd_Xs-zb5SS8Pw`)
3. Click "Edit"
4. In the **Redirect URIs** field, add your new callback URL on a new line:
   ```
   https://YOUR_GITHUB_USERNAME.github.io/inat-trees-selfhost/auth/callback
   ```
5. Keep the old Replit URL for now (you can remove it later)
6. Click "Save"

### 4. Push to GitHub

```bash
# Make sure you're in the repository directory
cd /path/to/iNat-Trees

# Commit the auth.js change
git add auth.js README.md DEPLOY.md .gitignore
git commit -m "Prepare for GitHub Pages deployment"

# Add your GitHub repository as remote
git remote add origin https://github.com/YOUR_USERNAME/inat-trees-selfhost.git

# Push to GitHub
git push -u origin claude/create-inat-trees-repo-sffwX
```

### 5. Enable GitHub Pages

1. Go to your repository on GitHub
2. Click **Settings** (top tab)
3. Click **Pages** (left sidebar)
4. Under "Source":
   - Select branch: `claude/create-inat-trees-repo-sffwX` (or `main` if you merged it)
   - Select folder: `/ (root)`
5. Click **Save**

GitHub will build and deploy your site. This takes 1-2 minutes.

### 6. Verify Deployment

1. Wait for the deployment to complete (you'll see a green checkmark in the Pages settings)
2. Your site will be available at: `https://YOUR_USERNAME.github.io/inat-trees-selfhost/`
3. Test the authentication flow:
   - Click "Connect my iNaturalist account"
   - Log in with iNaturalist
   - You should be redirected back to your app

### 7. Optional: Custom Domain

If you want to use a custom domain:

1. In repository Settings → Pages, add your custom domain (e.g., `trees.yourdomain.com`)
2. Update DNS settings with your domain provider:
   - Add a CNAME record pointing to `YOUR_USERNAME.github.io`
3. Update `auth.js` redirect URI to use your custom domain
4. Update the iNaturalist OAuth app redirect URI as well

## Alternative: Deploy to Netlify

### Quick Deploy

1. Go to https://app.netlify.com/
2. Click "Add new site" → "Import an existing project"
3. Connect to GitHub and select your `inat-trees-selfhost` repository
4. Build settings:
   - Build command: (leave empty)
   - Publish directory: `.` or `/`
5. Click "Deploy"

Your site will be live at `https://random-name.netlify.app`

### Custom Domain on Netlify

1. In Site settings → Domain management
2. Click "Add custom domain"
3. Follow the DNS setup instructions
4. Update `auth.js` and iNaturalist OAuth app with the new domain

## Alternative: Deploy to Cloudflare Pages

Since you're already using Cloudflare Workers, Cloudflare Pages is a great option:

1. Go to https://dash.cloudflare.com/
2. Select "Pages" from the sidebar
3. Click "Create a project"
4. Connect your GitHub repository
5. Build settings:
   - Build command: (leave empty)
   - Build output directory: `/`
6. Click "Save and Deploy"

Your site will be live at `https://inat-trees-selfhost.pages.dev`

Benefits:
- Same Cloudflare account as your Worker
- Automatic HTTPS
- Fast global CDN
- Free custom domains

## Troubleshooting

### OAuth Redirect Error
- Double-check the redirect URI in `auth.js` matches exactly
- Make sure you added it to your iNaturalist OAuth app
- Check for trailing slashes (should be consistent)

### 404 on GitHub Pages
- Make sure the branch is set correctly in Settings → Pages
- Wait a few minutes for the deployment to complete
- Check the Actions tab for build errors

### CORS Errors
- The Cloudflare Worker should already have CORS enabled
- If you see CORS errors, check the Worker logs

### Assets Not Loading
- Check that the `assets/` and `attached_assets/` folders are in your repository
- Verify file paths are relative (no leading `/` for GitHub Pages in subdirectory)

## Post-Deployment

After successful deployment:

1. **Test all features**:
   - Authentication
   - Tree building
   - Checkpoints
   - Timeline slider
   - Export functions

2. **Update any documentation** with your new URL

3. **Remove Replit deployment** (optional):
   - You can keep it as a backup
   - Or shut it down to avoid confusion

4. **Share your new URL** with users

## Updating the App

To update your deployed app:

```bash
# Make your changes
git add .
git commit -m "Description of changes"
git push

# GitHub Pages will automatically redeploy (takes 1-2 minutes)
```

## Backend Maintenance

Remember: The Cloudflare Worker backend is separate and continues to run at:
```
https://inat-trees-worker.intrinsic3141.workers.dev
```

To update the backend, you'll need to:
1. Modify `worker.js` and `wrangler.toml` (kept separately)
2. Deploy with `wrangler deploy`

The frontend and backend are now independently deployable!
