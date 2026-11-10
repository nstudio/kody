const { contextBridge, ipcRenderer } = require('electron')

// The quick panel is a desktop-owned file:// page. Its bridge is limited to asking for results, running one by id,
// and closing; it never receives tokens, URLs to load, or shell access.
contextBridge.exposeInMainWorld('labQuick', {
	query: (text) =>
		ipcRenderer.invoke('lab:quick', 'query', String(text ?? '').slice(0, 200)),
	run: (id) =>
		ipcRenderer.invoke('lab:quick', 'run', String(id ?? '').slice(0, 200)),
	hide: () => ipcRenderer.invoke('lab:quick', 'hide'),
	onShow: (callback) => {
		const listener = (_event, state) => callback(state)
		ipcRenderer.on('lab:quick-show', listener)
		return () => ipcRenderer.removeListener('lab:quick-show', listener)
	},
})
