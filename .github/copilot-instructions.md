# Noto Electron App - Development Guide

This is an Electron desktop application project built with HTML, CSS, and JavaScript.

## Project Overview

- **Framework**: Electron (cross-platform desktop app)
- **Frontend**: Vanilla HTML, CSS, JavaScript
- **Purpose**: Simple, customizable desktop application template

## Quick Start

1. Install dependencies: `npm install`
2. Run the app: `npm start`
3. For debugging: uncomment `mainWindow.webContents.openDevTools();` in `main.js`

## Key Files

- `main.js` - Electron main process
- `preload.js` - Secure context bridge
- `src/index.html` - Application UI
- `src/styles.css` - Application styling
- `src/renderer.js` - UI interactivity

## Development Tips

- Modify UI in `src/` folder
- Use `src/renderer.js` for JavaScript logic
- Customize colors in `src/styles.css` CSS variables
- Hot reload: Use electron-reload for faster development

## Next Steps

- Add more features in renderer.js
- Customize styling to match your brand
- Implement IPC for main process communication
- Package for distribution with electron-builder
