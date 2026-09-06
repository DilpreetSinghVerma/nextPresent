const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class KeySender {
  constructor() {
    this.process = null;
    this.isReady = false;
    this.pendingResolves = [];
    this.init();
  }

  init() {
    let exePath = path.join(__dirname, '..', 'bin', 'keySender.exe');
    if (!fs.existsSync(exePath) && process.resourcesPath) {
      const packagedPath = path.join(process.resourcesPath, 'bin', 'keySender.exe');
      if (fs.existsSync(packagedPath)) {
        exePath = packagedPath;
      }
    }
    if (!fs.existsSync(exePath) && exePath.includes('app.asar')) {
      const unpackedPath = exePath.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpackedPath)) {
        exePath = unpackedPath;
      }
    }

    if (fs.existsSync(exePath)) {
      try {
        this.process = spawn(exePath, [], {
          stdio: ['pipe', 'pipe', 'inherit'],
          windowsHide: true
        });

        this.process.stdout.on('data', (data) => {
          const lines = data.toString().split('\n');
          for (let line of lines) {
            line = line.trim();
            if (line === 'KEYSENDER_READY') {
              this.isReady = true;
              // Flush any queued keys
              while (this.pendingResolves.length > 0) {
                const item = this.pendingResolves.shift();
                this._write(item.command);
                item.resolve(true);
              }
            }
          }
        });

        this.process.on('error', (err) => {
          console.error('[KeySender] Native process error:', err.message);
          this.process = null;
          this.isReady = false;
        });

        this.process.on('exit', (code) => {
          console.warn(`[KeySender] Native process exited with code ${code}`);
          this.process = null;
          this.isReady = false;
        });
      } catch (err) {
        console.error('[KeySender] Failed to spawn native keySender.exe:', err);
      }
    } else {
      console.warn('[KeySender] keySender.exe not found. Will use fallback injector.');
    }
  }

  _write(command) {
    if (this.process && this.process.stdin && this.process.stdin.writable) {
      this.process.stdin.write(command.toUpperCase() + '\n');
      return true;
    }
    return false;
  }

  send(command) {
    return new Promise((resolve) => {
      const cmd = command.toUpperCase().trim();

      if (this.isReady && this.process) {
        this._write(cmd);
        resolve(true);
      } else if (this.process && !this.isReady) {
        this.pendingResolves.push({ command: cmd, resolve });
      } else {
        // Fallback using Python ctypes
        this._sendPythonFallback(cmd)
          .then(() => resolve(true))
          .catch(() => resolve(false));
      }
    });
  }

  _sendPythonFallback(command) {
    return new Promise((resolve, reject) => {
      const keyMap = {
        'NEXT': '0x22',           // VK_NEXT (Page Down - universal next)
        'PREV': '0x21',           // VK_PRIOR (Page Up - universal prev)
        'NEXT_ARROW': '0x22',     // Page Down
        'PREV_ARROW': '0x21',     // Page Up
        'NEXT_PPT': '0x22',
        'PREV_PPT': '0x21',
        'NEXT_PGDN': '0x22',
        'PREV_PGUP': '0x21',
        'NEXT_SPACE': '0x20',
        'PREV_BACKSPACE': '0x08',
        'NEXT_DOWN': '0x28',
        'PREV_UP': '0x26',
        'PAGE_DOWN': '0x22',
        'PAGE_UP': '0x21',
        'F5': '0x74',
        'SHIFT_F5': '0x74',
        'ESC': '0x1B',
        'B': '0x42',
        'W': '0x57'
      };

      const vk = keyMap[command] || (command.includes('PREV') ? '0x21' : '0x22');
      const script = `
import ctypes, time
u = ctypes.windll.user32
u.keybd_event(${vk}, 0, 1, 0)
time.sleep(0.02)
u.keybd_event(${vk}, 0, 3, 0)
`;
      const py = spawn('python', ['-c', script], { windowsHide: true });
      py.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Python fallback failed with code ${code}`));
      });
      py.on('error', reject);
    });
  }

  destroy() {
    if (this.process) {
      try {
        this.process.stdin.write('QUIT\n');
        this.process.kill();
      } catch (_) {}
    }
  }
}

module.exports = new KeySender();
