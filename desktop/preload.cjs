const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('widget', {
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  login: call('login'), signup: call('signup'), logout: call('logout'), start: call('start'), stop: call('stop'), pause: call('pause'), resume: call('resume'), consent: call('consent'),
  setOpen: call('set-open'), dragStart: call('drag-start'), dragMove: call('drag-move'), dragEnd: call('drag-end'), grant: call('grant'), openSettings: call('open-settings'), openDashboard: call('open-dashboard'),
  relaunch: call('relaunch'), resize: call('resize'), quit: call('quit'),
  prompt: { onData: (cb) => ipcRenderer.on('prompt', (_e, d) => cb(d)), answer: call('prompt-answer'), resize: call('prompt-resize') },
});
