const { app, BrowserWindow } = require('electron');
const startServer = require('./server');

const PORT = 3000;
let win;

app.whenReady().then(() => {
  startServer(PORT);
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Badımcan Bəndələr',
    autoHideMenuBar: true,
  });
  win.loadURL(`http://localhost:${PORT}`);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
