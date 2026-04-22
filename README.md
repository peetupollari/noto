# Noto - Electron Desktop Application

A simple, modern Electron desktop application built with HTML, CSS, and JavaScript.

```python
print("Hello, World!")
```

> This is a quote

--- 

| Column 1 | Column 2 |
| -------- | -------- |
| Text | Text |

$$E = mc^2$$

~~strike through text~~

## Features

- ✨ Clean, modern UI with dark theme
- 🎨 Fully customizable HTML/CSS interface
- ⚙️ Interactive JavaScript functionality
- 🚀 Cross-platform desktop app (Windows, macOS, Linux)
- 🔒 Secure context isolation with preload script

## Project Structure

```
noto/
├── main.js                 # Main process (Electron entry point)
├── preload.js             # Preload script for secure IPC
├── package.json           # Project dependencies and metadata
├── src/
│   ├── index.html         # Main HTML file
│   ├── styles.css         # Application styles
│   └── renderer.js        # Renderer process (UI logic)
├── README.md              # Project documentation
└── .gitignore            # Git ignore file
```

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn

### Installation

1. Navigate to the project directory:
```bash
cd Noto
```

2. Install dependencies:
```bash
npm install
```

### Running the Application

Start the Electron app in development mode:
```bash
npm start
```

For debugging with DevTools enabled, uncomment the `mainWindow.webContents.openDevTools();` line in `main.js`.

## Building for Production

To package the application as an executable, you can use `electron-builder`:

1. Install electron-builder:
```bash
npm install --save-dev electron-builder
```

2. Add build script to `package.json`:
```json
"build": "electron-builder"
```

3. Run the build:
```bash
npm run build
```

## Development

### Modifying the UI

- **HTML**: Edit `src/index.html` to change the structure
- **Styles**: Edit `src/styles.css` to customize appearance
- **Logic**: Edit `src/renderer.js` to add interactivity

### IPC Communication

For communication between main and renderer processes:

1. In `main.js`, handle IPC messages:
```javascript
const { ipcMain } = require('electron');

ipcMain.handle('channel-name', (event, arg) => {
  // Handle message
  return result;
});
```

2. In `src/renderer.js`, send messages:
```javascript
window.electronAPI.send('channel-name', data);
```

## Architecture

- **Main Process** (`main.js`): Manages application window and lifecycle
- **Preload Script** (`preload.js`): Provides secure bridge between main and renderer
- **Renderer Process** (`src/renderer.js`): Handles UI interactions

## Security Features

- ✅ Context isolation enabled
- ✅ Node integration disabled
- ✅ Preload script for safe IPC
- ✅ No unsafe eval or inline scripts

## License

MIT

## Resources

- [Electron Documentation](https://www.electronjs.org/docs)
- [HTML/CSS/JavaScript MDN Docs](https://developer.mozilla.org/)
